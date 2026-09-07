import action from '../services/action.js';

await action.getPartantForToday();

await action.getPartantEquidiaForToday();

console.log('Partant cache loaded');