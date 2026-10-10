import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src/otzi/ holds Ötzi's own node:test suites, copied verbatim; they run
    // under `npm run test:otzi`, not vitest.
    exclude: [...configDefaults.exclude, 'src/otzi/**'],
  },
});
