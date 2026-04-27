/**
 * 邮件发送模块
 * 使用 nodemailer 通过 SMTP 发送验证码邮件
 *
 * 配置方式（优先级从高到低）：
 *   1. 环境变量 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *   2. .env 文件
 *   3. 本地 config/mail-config.json
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// 尝试加载 .env（主进程可能已加载，这里做保底）
try {
  require('dotenv').config();
} catch {}

function loadMailConfig() {
  // 1. 环境变量
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      fromName: process.env.SMTP_FROM_NAME || 'DesktopSecretary',
    };
  }

  // 2. 本地配置文件
  const configPath = path.join(__dirname, '..', '..', 'config', 'mail-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.host && cfg.auth?.user && cfg.auth?.pass) {
        return {
          host: cfg.host,
          port: cfg.port || 465,
          secure: cfg.secure !== false,
          auth: cfg.auth,
          fromName: cfg.fromName || 'DesktopSecretary',
        };
      }
    } catch {
      // 忽略解析错误
    }
  }

  return null;
}

const mailConfig = loadMailConfig();
let transporter = null;

if (mailConfig) {
  transporter = nodemailer.createTransport({
    host: mailConfig.host,
    port: mailConfig.port,
    secure: mailConfig.secure,
    auth: mailConfig.auth,
  });
}

function isConfigured() {
  return !!transporter;
}

async function sendVerifyCode(email, code) {
  if (!transporter) {
    throw new Error('邮件服务未配置，请联系管理员设置 SMTP');
  }

  const from = `"${mailConfig.fromName}" <${mailConfig.auth.user}>`;

  await transporter.sendMail({
    from,
    to: email,
    subject: '【DesktopSecretary】注册验证码',
    text: `您的注册验证码是：${code}，5分钟内有效。如非本人操作，请忽略此邮件。`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1a1a1a; font-size: 18px; margin-bottom: 16px;">注册验证码</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.6;">您正在注册 DesktopSecretary 账号，请填写以下验证码完成注册：</p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; color: #0099FF; letter-spacing: 8px;">${code}</span>
        </div>
        <p style="color: #999; font-size: 12px;">验证码 5 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。</p>
      </div>
    `,
  });
}

module.exports = {
  isConfigured,
  sendVerifyCode,
  loadMailConfig,
};
