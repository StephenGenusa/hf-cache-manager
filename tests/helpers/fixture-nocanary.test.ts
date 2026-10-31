import { expect, it } from 'vitest';
import { buildFixture } from './fixture';

it('refuses to build without useCanaries', async () => {
  await expect(buildFixture({ repos: [] })).rejects.toThrow('buildFixture requires useCanaries() in this test file');
});
