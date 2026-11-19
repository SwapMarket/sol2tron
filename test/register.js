// Node resolves the page's bare module names ('solana', 'tron', …) the way the page's import map does.
import { register } from 'node:module';
register('./resolve.js', import.meta.url);
