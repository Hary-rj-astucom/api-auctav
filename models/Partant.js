const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const Partant = sequelize.define("Partant", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  nom: { type: DataTypes.STRING(50), allowNull: false },
  naissance: { type: DataTypes.STRING(25), allowNull: false },
  sexe: { type: DataTypes.STRING(5), allowNull: false },
  pere: { type: DataTypes.STRING(50), allowNull: true },
  mere: { type: DataTypes.STRING(50), allowNull: true },
  discipline: { type: DataTypes.STRING(25), allowNull: true },
  date: { type: DataTypes.STRING(50), allowNull: true },
  course: { type: DataTypes.STRING(10), allowNull: false },
  prix: { type: DataTypes.STRING(180), allowNull: false },
  hippodrome: { type: DataTypes.STRING(100), allowNull: false },
  distance: { type: DataTypes.STRING(25), allowNull: true },
  record: { type: DataTypes.STRING(10), allowNull: true },
  gains: { type: DataTypes.STRING(25), allowNull: true },
  reduction: { type: DataTypes.STRING(10), allowNull: true },
  reduction_date: { type: DataTypes.DATE, allowNull: true },
  reduction_lieu: { type: DataTypes.STRING(100), allowNull: true },
  urlPerfs: { type: DataTypes.STRING(160), allowNull: false }
}, {
  tableName: "partant",
  timestamps: false
});

module.exports = Partant;