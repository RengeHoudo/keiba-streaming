export const $ = selector => document.querySelector(selector);
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const setText = (selector, text) => { $(selector).textContent = text; };
export { connect, requestAction, BROWSER_MODE, controlUrl, overlayUrl, getJraSchedule, getJraResult } from './transport.js';
