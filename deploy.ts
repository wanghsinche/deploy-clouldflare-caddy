import fs from 'fs';
import path from 'path';
import pem from 'pem';
import Cloudflare from 'cloudflare';

// 读取配置文件
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// 初始化 Cloudflare API
const cf = new Cloudflare({
  apiToken: config.cloudflare.api_token,
  apiEmail: config.cloudflare.email,
});

// 服务类型定义
interface Services {
  [domain: string]: number;
}

// 生成 Caddyfile 内容
function generateCaddyfile(services: Services): string {
  let caddyfileContent = '';
  
  for (const [domain, port] of Object.entries(services)) {
    caddyfileContent += `
${domain} {
  reverse_proxy localhost:${port}
  tls internal
}
`;
  }
  
  return caddyfileContent;
}

// 生成自签名证书
async function generateSelfSignedCertificate(domain: string): Promise<{certificate: string, clientKey: string}>{
  return new Promise((resolve, reject) => {
    pem.createCertificate({ selfSigned: true, commonName: domain }, (err, keys) => {
      if (err) {
        return reject(err);
      }
      resolve(keys);
    });
  });
}

// 生成 CSR
async function generateCSR(domain: string): Promise<{csr: string, clientKey: string}> {
  return new Promise((resolve, reject) => {
    pem.createCSR({
      commonName: domain,
      organization: 'My Company',
      organizationUnit: 'IT Department',
      country: 'US',
    }, (err, keys) => {
      if (err) {
        return reject(err);
      }
      resolve({
        csr: keys.csr,
        clientKey: keys.clientKey
      });
    });
  });
}

// 上传证书到 Cloudflare
async function uploadCertificate(domain: string, zoneId: string, validityDays: number): Promise<void> {
  try {
    // 生成 CSR
    const { csr, clientKey } = await generateCSR(domain);
    
    // 创建证书
    await cf.clientCertificates.create({
      zone_id: zoneId,
      csr: csr,
      validity_days: validityDays
    });
    
    // 保存私钥到本地
    const certDir = path.join(__dirname, 'certs');
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir);
    }
    fs.writeFileSync(path.join(certDir, `${domain}.key`), clientKey);
    
    console.log(`Certificate uploaded for ${domain}`);
  } catch (error) {
    console.error(`Error uploading certificate for ${domain}:`, error);
  }
}


// 设置 Cloudflare DNS 和代理
async function setupCloudflare(): Promise<void> {
  for (const [domain, port] of Object.entries(config.services)) {
    try {
      // 获取域名的根域名
      const zoneName = domain.split('.').slice(-2).join('.');
      
      // 获取 zone ID
      const zones = await cf.zones.list();
      const zone = zones.result.find(z => z.name === zoneName);

      if (!zone) {
        console.error(`Zone not found for ${domain}`);
        continue;
      }
      
      // 创建或更新 DNS 记录
      const dnsRecords = await cf.dns.records.list({
          match: 'all',
          name: {
              exact: domain,
          },
          page: 1,
          per_page: 100,
          type: 'A',
          zone_id: zone.id
      });
      const existingRecord = dnsRecords.result.find((record) => record.name === domain && record.type === 'A');


      if (existingRecord) {
        // 更新 DNS 记录
        await cf.dns.records.edit(existingRecord.id, {
            zone_id: zone.id,
            comment: 'Created by Caddy Deploy @' + new Date().toISOString(),
            content: config.server_ip,  
            name: domain,
            proxied: true,
            type: 'A',
        }, {});
        console.log(`DNS record updated for ${domain}`);
      } else {
        // 添加新 DNS 记录
        await cf.dns.records.create({
            zone_id: zone.id,
            comment: 'Created by Caddy Deploy @' + new Date().toISOString(),
            content: config.server_ip,
            name: domain,
            proxied: true,
            type: 'A',
        }, {});
        console.log(`DNS record created for ${domain}`);
      }
      
      // 生成自签名证书
      const { certificate, clientKey } = await generateSelfSignedCertificate(domain);
      
      // 上传证书到 Cloudflare
      await uploadCertificate(domain, zone.id, 3650);
      
      
      // 保存证书到本地
      fs.writeFileSync(path.join(__dirname, 'certs', `${domain}.crt`), certificate);
      fs.writeFileSync(path.join(__dirname, 'certs', `${domain}.key`), clientKey);
    } catch (error) {
      console.error(`Error setting up ${domain}:`, error);
    }
  }
}

// 生成并保存 Caddyfile
function setupCaddy(): void {
  const caddyfileContent = generateCaddyfile(config.services);
  fs.writeFileSync('Caddyfile', caddyfileContent);
  console.log('Caddyfile generated');
}

// 生成 Nginx 配置文件内容
function generateNginxConfig(services: Services): string {
  let nginxConfig = '';
  
  // 添加 HTTP 服务器配置（重定向到 HTTPS）
  for (const domain of Object.keys(services)) {
    const certPath = path.resolve(__dirname, 'certs', `${domain}.crt`);
    const keyPath = path.resolve(__dirname, 'certs', `${domain}.key`);

    nginxConfig += `
server {
    listen 80;
    server_name ${domain};
    return 301 https://$server_name$request_uri;
}`;
  }
  
  // 添加 HTTPS 服务器配置
  for (const [domain, port] of Object.entries(services)) {
    const certPath = path.resolve(__dirname, 'certs', `${domain}.crt`);
    const keyPath = path.resolve(__dirname, 'certs', `${domain}.key`);

    nginxConfig += `
server {
    listen 443 ssl;
    server_name ${domain};

    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://localhost:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
  }
  
  return nginxConfig;
}

// 设置 Nginx 配置
function setupNginx(): void {
  const nginxConfig = generateNginxConfig(config.services);
  const nginxConfigPath = path.join(__dirname, 'nginx.conf');
  fs.writeFileSync(nginxConfigPath, nginxConfig);
  console.log('Nginx configuration generated');
}

// 修改主函数，添加 Nginx 配置生成
async function main(): Promise<void> {
  try {
    await setupCloudflare();
    setupCaddy();
    setupNginx();  // 添加这一行
    console.log('Setup completed successfully');
  } catch (error) {
    console.error('Setup failed:', error);
  }
}

main();