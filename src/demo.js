import { initialState, applyAction } from './state.js';
import { expandFormation } from './domain.js';

// Entirely fictional examples. Never read local data or uploaded design files.
export function demoState() {
  let state = applyAction(initialState(), { type: 'race.update', payload: { fields: { venue: 'サンプル', number: 11, name: 'サンプルレース（架空）', surface: '芝', distance: 1600, startTime: '15:40' } } });
  const tickets = [
    ...expandFormation('wide', [[3,6,10,14], [3,6,10,14]]).map(numbers => ({ type: 'wide', numbers, amount: 100 })),
    ...[7,9,12,15].map(n => ({ type: 'trio', numbers: [2,4,n], amount: 200 })),
    ...[5,8,11].map(n => ({ type: 'exacta', numbers: [14,n], amount: 100 })),
    ...[5,8,11].map(n => ({ type: 'trifecta', numbers: [14,2,n], amount: 100 })),
    { type: 'win', numbers: [14], amount: 500 },
  ];
  return applyAction(state, { type: 'tickets.add', payload: { tickets } });
}
