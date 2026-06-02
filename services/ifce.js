const axios = require('axios');
const qs = require('querystring');

async function getToken() {
    const data = qs.stringify({
        grant_type: 'password',
        username: process.env.IFCE_USERNAME,
        password: process.env.IFCE_PASSWORD,
        response_type: 'id_token token',
        scope: 'openid profile ws4g',
        client_id: process.env.IFCE_CLIENT_ID,
        client_secret: process.env.IFCE_CLIENT_SECRET
    });

    const response = await axios.post(
        process.env.IFCE_URL_TOKEN,
        data,
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );

    return response.data;
}

async function getInfoHorseIFCE(sire_number){
    try{

        const token = await getToken();

        const response = await axios.get(
            `${process.env.IFCE_BASE_URL}/horses/${sire_number}/genealogy`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token.access_token}`
                }
            }
        )

        const date_naissance = response.data.birthDate;
        const annee_naissance = date_naissance.split("-")[0];

        const color_horse = response.data.colorCode;
        const robe = color_horse.charAt(0).toUpperCase() + color_horse.slice(1).toLowerCase();

        const result = {
            nom: response.data.birthName,
            pays: response.data.birthCountryCode,
            race: response.data.breedCode,
            sexe: response.data.sexCode,
            robe:  robe,
            annee: annee_naissance,
            dateNaissance: date_naissance,
            pere: response.data.father.birthName,
            mere: response.data.mother.birthName,
            peremere: response.data.mother.father.birthName
        }

        return [result];

    } catch(err){
        console.error(`❌Echec de l'appel api IFCE:`, err.message);
        throw err;
    }
}

module.exports = {
    getInfoHorseIFCE
};