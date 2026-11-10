import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../src/background-controller.js';

export default defineBackground(() => {
  startBackground();
});
