import { initialState, applyAction } from '../src/state.js';
export const sampleNumbers = [[6,7,9],[6,7,11],[6,7,13],[6,7,16],[6,9,18],[6,11,18],[6,13,18],[6,16,18]];
export const sampleTickets = () => sampleNumbers.map(numbers => ({ type: 'trio', numbers, amount: 100, source: 'paste' }));
export const sampleState = () => applyAction(initialState(), { type: 'tickets.add', payload: { tickets: sampleTickets() } });
