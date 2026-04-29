import '@testing-library/jest-dom';

// jsdom does not ship TextEncoder/TextDecoder — polyfill from Node for SSE stream tests.
import { TextEncoder, TextDecoder } from 'util';
Object.assign(global, { TextEncoder, TextDecoder });
