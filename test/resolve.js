const LOCAL = new Set(['solana', 'tron', 'mesh', 'oneclick']);
export async function resolve(specifier, context, next) {
  if (LOCAL.has(specifier)) return next(new URL(`../${specifier}.js`, import.meta.url).href, context);
  return next(specifier, context);
}
