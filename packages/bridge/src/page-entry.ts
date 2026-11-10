import { installPageEndpoint, type PageRuntime } from './page-endpoint.js';

declare const chrome: { runtime: PageRuntime };

installPageEndpoint(chrome.runtime);
