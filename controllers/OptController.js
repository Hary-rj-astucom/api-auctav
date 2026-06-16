const sequelize = require("../config/database.js");
const Otp = require("../models/Otp.js");
const mailer = require("../services/mail.js");

// generate the OTP
const generateOtp = async (req, res) => {
    try {

        const email = req.body.email;
        const ip_adress = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
        const source = req.headers['user-agent'];

        let otp = "";
        for (let i = 0; i < 6; i++) {
            otp += Math.floor(Math.random() * 10);
        }

        const insered = await Otp.create({
            email: email,
            ip_adress: ip_adress,
            source: source,
            otp: otp,
            date_created: new Date().toISOString(),
            expire_time: 180,
            state: 1
        });

        // envoie mail de l'otp
        await mailer.mailAuctav(email, "One time Password", 
            `<p>Bonjour,</p> 
            <p> Un code OTP a été généré pour sécuriser votre action : <span style="font-size: 18px; font-weight: bold; color: #2c3e50;"> ${ insered.otp } </span> </p> 
            <p> Votre code est valide pendant : <span style="color: #e74c3c;">${ insered.expire_time } secondes</span> </p> 
            <p> Veuillez utiliser ce code avant son expiration. Passé ce délai, il ne sera plus valide et vous devrez en demander un nouveau. </p>`
        );

        res.json({message: "otp generated"});

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
};

// Vérification de l'OTP
const verificationOtp = async (req, res) => {
    try {

        const { email, otp } = req.body;

        const otpObject = await Otp.findOne({
            where: {
                email,
                otp,
                state: 1
            }
        });

        if (!otpObject) {
            return res.status(401).json({
                access: false,
                message: "Accès refusé"
            });
        }

        // Date d'expiration
        const expiredAt = new Date(
            otpObject.date_created.getTime() +
            (otpObject.expire_time * 1000)
        );

        const now = new Date();

        // Marquer l'OTP comme utilisé
        await Otp.update(
            { state: 2 },
            { where: { id: otpObject.id } }
        );

        if (now <= expiredAt) {
            return res.status(200).json({
                access: true,
                message: "Accès autorisé"
            });
        }

        return res.status(401).json({
            access: false,
            message: "OTP expiré"
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            error: err.message
        });
    }
};

module.exports = {
  generateOtp,
  verificationOtp,
};
