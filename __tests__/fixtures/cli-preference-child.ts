import { setProjectCliPreference } from '../../src/cubes.js';

// All contenders load the real persistence code before starting together.
process.send!('ready');
process.once('message', async () => {
  try {
    await setProjectCliPreference('opencode', process.argv[2]);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
