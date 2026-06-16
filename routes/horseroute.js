const express = require("express");
const HorseController = require("../controllers/HorseController.js");

const router = express.Router();

router.get("/api/partants", HorseController.getPartant);
router.get("/api/partantsRP", HorseController.getPartantRP);
router.get("/api/engages", HorseController.getEngages);
router.get("/api/cheval/:slug/:horse_id", HorseController.getHorse);
router.get("/api/programme", HorseController.getProgamme);
router.get("/api/horseperf", HorseController.horseperf);
router.get("/api/infohorseifce", HorseController.getinfohorseIFCE);

module.exports = router