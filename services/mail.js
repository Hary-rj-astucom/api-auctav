const nodemailer = require("nodemailer");

async function mailAuctav(to, subject, message, headers = "", from = "", smtpDebug = 0) {
  try {
    // Transport SMTP (équivalent PHPMailer config)
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: 587,
      secure: false, // STARTTLS (équivalent PHPMailer port 587)
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD,
      },
      tls: {
        rejectUnauthorized: true,
      },
      debug: smtpDebug > 0,
      logger: smtpDebug > 0,
    });

    // Envoi email
    const info = await transporter.sendMail({
      from: '"Auctav" <webmaster@auctav.com>',
      to: to,
      subject: Buffer.from(subject, "utf8").toString(), // équivalent utf8_decode PHP
      html: Buffer.from(message, "utf8").toString(),
      text: message.replace(/<[^>]*>/g, ""), // strip_tags équivalent
    });

    return "Message envoyé : " + info.messageId;
  } catch (error) {
    return error.message;
  }
}

module.exports = {
    mailAuctav
};