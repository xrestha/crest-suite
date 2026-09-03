// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// TextEncoder/TextDecoder are in every browser and in Node, but NOT in the jsdom build that ships
// with react-scripts 5's Jest 27. react-router 7 reaches for TextEncoder at import time, so without
// this shim ANY test that renders a component using the router dies at the import, before a single
// assertion runs — which is a large part of why this codebase has almost no component tests.
//
// Paired with the react-router moduleNameMapper entries in package.json: react-router-dom@7.17
// declares `main: ./dist/main.js`, a file it does not ship, and Jest 27 resolves by `main` because
// it predates the `exports` field. Those two fixes together are what make it possible to test a
// page rather than only a pure function.
if (typeof global.TextEncoder === 'undefined') {
  // eslint-disable-next-line global-require
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}
