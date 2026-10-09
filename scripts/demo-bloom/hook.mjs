// Lets Node import the app's extensionless `./x` modules (CRA resolves them; Node does not).
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (e) {
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.[cm]?jsx?$/.test(specifier)) {
      try { return await next(specifier + '.js', context) } catch { return next(specifier + '/index.js', context) }
    }
    throw e
  }
}
