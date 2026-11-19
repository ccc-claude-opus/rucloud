// cloudflare:email：EmailMessage（寄件者、收件者、MIME 格式的內容），交給 send_email 綁定的 send() 寄出
export class EmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
