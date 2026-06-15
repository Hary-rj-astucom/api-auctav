const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const Otp = sequelize.define("Otp", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(50), allowNull: false },
    ip_adress: { type: DataTypes.STRING(25), allowNull: false },
    source: { type: DataTypes.STRING(25), allowNull: false },
    otp: { type: DataTypes.STRING(20), allowNull: false },
    date_created: { type: DataTypes.DATE, allowNull: true },
    expire_time: { type: DataTypes.INTEGER, allowNull: true},
    state: { type: DataTypes.INTEGER, allowNull: false}
}, {
  tableName: "otp",
  timestamps: false
});

module.exports = Otp;