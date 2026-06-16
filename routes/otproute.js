const express = require("express");
const OtpController = require("../controllers/OptController.js");

const router = express.Router();

router.post("/generate", OtpController.generateOtp);
router.post("/checking", OtpController.verificationOtp);

module.exports = router;