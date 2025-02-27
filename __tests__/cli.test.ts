/**
 * MIT License
 *
 * Copyright (c) 2020-present, Elastic NV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { Server } from './utils/server';

describe('CLI', () => {
  let server: Server;
  let serverParams: { url: string };
  beforeAll(async () => {
    server = await Server.create({ tls: false });
    serverParams = { url: server.TEST_PAGE };
  });
  afterAll(async () => await server.close());

  const FIXTURES_DIR = join(__dirname, 'fixtures');

  it('runs inline tests', async () => {
    const cli = new CLIMock()
      .stdin(
        `step('check h2', async () => {
        await page.goto(params.url, { timeout: 1500 });
        const sel = await page.waitForSelector('h2.synthetics', { timeout: 1500 });
        expect(await sel.textContent()).toBe("Synthetics test page");
      })`
      )
      .args(['--inline', '--params', JSON.stringify(serverParams)])
      .run();
    await cli.waitFor('Journey: inline');
    expect(await cli.exitCode).toBe(0);
  });

  // TODO: Delete this once --suite-params is removed
  it('runs with legacy suite-params', async () => {
    const cli = new CLIMock()
      .stdin(
        `step('check h2', async () => {
        await page.goto(params.url, { timeout: 1500 });
        const sel = await page.waitForSelector('h2.synthetics', { timeout: 1500 });
        expect(await sel.textContent()).toBe("Synthetics test page");
      })`
      )
      .args(['--inline', '--suite-params', JSON.stringify(serverParams)])
      .run();
    await cli.waitFor('Journey: inline');
    expect(await cli.exitCode).toBe(0);
  });

  it('run suites and exit with 0', async () => {
    const cli = new CLIMock()
      .args([join(FIXTURES_DIR, 'fake.journey.ts')])
      .run();
    await cli.waitFor('Journey: fake journey');
    expect(cli.output()).toContain('fake journey');
    expect(await cli.exitCode).toBe(0);
  });

  it('run suites and exit with 1', async () => {
    const cli = new CLIMock()
      .args([join(FIXTURES_DIR, 'error.journey.ts')])
      .run();
    await cli.waitFor('boom');
    expect(await cli.exitCode).toBe(1);
  });

  it('runs the suites with --quiet-exit-code, always exiting with 0', async () => {
    const cli = new CLIMock()
      .args([join(FIXTURES_DIR, 'error.journey.ts'), '--quiet-exit-code'])
      .run();
    await cli.waitFor('boom');
    expect(await cli.exitCode).toBe(0);
  });

  it('produce json with reporter=json flag', async () => {
    const output = async args => {
      const cli = new CLIMock()
        .args([join(FIXTURES_DIR, 'fake.journey.ts'), ...args])
        .run();
      await cli.waitFor('fake journey');
      expect(await cli.exitCode).toBe(0);
      return JSON.parse(cli.output());
    };
    expect((await output(['--reporter', 'json'])).journey).toEqual({
      id: 'fake journey',
      name: 'fake journey',
    });
  });

  it('mimick new heartbeat with `--rich-events` flag', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'example.journey.ts'),
        join(FIXTURES_DIR, 'error.journey.ts'),
        '--rich-events',
        '--params',
        JSON.stringify(serverParams),
      ])
      .run();
    await cli.waitFor('journey/end');

    const screenshotRef = cli
      .buffer()
      .map(data => JSON.parse(data))
      .find(({ type }) => type === 'step/screenshot_ref');
    expect(screenshotRef).toMatchObject({
      journey: {
        id: 'example journey',
        name: 'example journey',
      },
      root_fields: expect.any(Object),
    });

    const networkData = cli
      .buffer()
      .map(data => JSON.parse(data))
      .find(({ type }) => type === 'journey/network_info');
    expect(networkData).toBeDefined();

    expect(await cli.exitCode).toBe(0);
  }, 30000);

  it('override screenshots with `--rich-events` flag', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'fake.journey.ts'),
        '--rich-events',
        '--screenshots',
        'off',
      ])
      .run();
    await cli.waitFor('journey/end');
    const screenshots = cli
      .buffer()
      .map(data => JSON.parse(data))
      .find(({ type }) => type === 'step/screenshot_ref');
    expect(screenshots).not.toBeDefined();
    expect(await cli.exitCode).toBe(0);
  });

  it('screenshots with device emulation', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'fake.journey.ts'),
        '--rich-events',
        '--config',
        join(FIXTURES_DIR, 'synthetics.config.ts'),
      ])
      .run();
    await cli.waitFor('journey/end');
    const data = cli.buffer().map(data => {
      try {
        return JSON.parse(data);
      } catch (e) {
        throw `Error ${e} could not parse data '${data}'`;
      }
    });
    const screenshotRef = data.find(
      ({ type }) => type === 'step/screenshot_ref'
    );
    const screenshotBlocks = data.filter(
      ({ type }) => type === 'screenshot/block'
    );
    expect(screenshotRef).toBeDefined();
    expect(screenshotBlocks.length).toBe(64);
    expect(await cli.exitCode).toBe(0);
  });

  it('pass dynamic config to journey params', async () => {
    // jest by default sets NODE_ENV to `test`
    const original = process.env['NODE_ENV'];
    const output = async () => {
      const cli = new CLIMock()
        .args([
          join(FIXTURES_DIR, 'fake.journey.ts'),
          '--reporter',
          'json',
          '--config',
          join(FIXTURES_DIR, 'synthetics.config.ts'),
        ])
        .run();
      await cli.waitFor('journey/start');
      expect(await cli.exitCode).toBe(0);
      return cli.output();
    };

    expect(JSON.parse(await output()).payload).toMatchObject({
      params: { url: 'non-dev' },
    });
    process.env['NODE_ENV'] = 'development';
    expect(JSON.parse(await output()).payload).toMatchObject({
      params: { url: 'dev' },
    });
    process.env['NODE_ENV'] = original;
  });

  it('pass playwright options to runner', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'pwoptions.journey.ts'),
        '--reporter',
        'json',
        '--config',
        join(FIXTURES_DIR, 'synthetics.config.ts'),
      ])
      .run();
    await cli.waitFor('step/end');
    const output = cli.output();
    expect(await cli.exitCode).toBe(0);
    expect(JSON.parse(output).step).toMatchObject({
      status: 'succeeded',
    });
  });

  it('params wins over config params', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'fake.journey.ts'),
        '--reporter',
        'json',
        '--config',
        join(FIXTURES_DIR, 'synthetics.config.ts'),
        '-p',
        '{"url": "suite-url"}',
      ])
      .run();
    await cli.waitFor('journey/start');
    const output = cli.output();
    expect(await cli.exitCode).toBe(0);
    expect(JSON.parse(output).payload).toMatchObject({
      params: { url: 'suite-url' },
    });
  });

  it('throw error on modifying params', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'params-error.journey.ts'),
        '--reporter',
        'json',
      ])
      .run();
    expect(await cli.exitCode).toBe(1);
    const output = cli.output();
    expect(JSON.parse(output).error).toMatchObject({
      name: 'TypeError',
      message: 'Cannot add property foo, object is not extensible',
    });
  });

  it('support capability flag', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'example.journey.ts'),
        '--params',
        JSON.stringify(serverParams),
        '--reporter',
        'json',
        '--capability',
        'metrics',
      ])
      .run();
    await cli.waitFor('step/end');
    const output = JSON.parse(cli.output());
    expect(output.payload.pagemetrics).toBeDefined();
    expect(await cli.exitCode).toBe(0);
  });

  it('show warn for unknown capability flag', async () => {
    const cli = new CLIMock()
      .args([
        join(FIXTURES_DIR, 'fake.journey.ts'),
        '--reporter',
        'json',
        '--capability',
        'unknown',
      ])
      .run();
    try {
      await cli.exitCode;
    } catch (e) {
      expect(e.message).toMatch('Missing capability "unknown"');
    }
  });

  it('run expect assetions with type check', async () => {
    // flag turns on type checking
    process.env['TS_NODE_TYPE_CHECK'] = 'true';
    const cli = new CLIMock()
      .args([join(FIXTURES_DIR, 'expect.journey.ts')])
      .run();
    expect(await cli.exitCode).toBe(0);
    process.env['TS_NODE_TYPE_CHECK'] = 'false';
  });

  describe('TLS site with self-signed cert', () => {
    let tlsServer: Server;
    let cliArgs: Array<string>;

    beforeAll(async () => {
      tlsServer = await Server.create({ tls: true });
      cliArgs = [
        join(FIXTURES_DIR, 'example.journey.ts'),
        '--params',
        JSON.stringify({ url: tlsServer.TEST_PAGE }),
        '--reporter',
        'json',
      ];
    });

    afterAll(async () => await tlsServer.close());

    it('fails by default', async () => {
      const cli = new CLIMock().args(cliArgs).run();
      expect(await cli.exitCode).toBe(1);
      expect(JSON.parse(cli.output()).journey).toEqual(
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('succeeds succeeds with --ignore-https-errors', async () => {
      const cli = new CLIMock()
        .args(cliArgs.concat('--ignore-https-errors'))
        .run();
      expect(await cli.exitCode).toBe(0);
      expect(JSON.parse(cli.output()).journey).toEqual(
        expect.objectContaining({ status: 'succeeded' })
      );
    });
  });
});

class CLIMock {
  private process: ChildProcess;
  private data = '';
  private chunks: Array<string> = [];
  private waitForText: string;
  private waitForPromise: () => void;
  private cliArgs: string[];
  private stdinStr?: string;
  exitCode: Promise<number>;

  constructor() {}

  args(a: string[]): CLIMock {
    this.cliArgs = a;
    return this;
  }

  stdin(s: string): CLIMock {
    this.stdinStr = s;
    return this;
  }

  run(): CLIMock {
    this.process = spawn(
      'node',
      [join(__dirname, '..', 'dist', 'cli.js'), ...this.cliArgs],
      {
        env: process.env,
        stdio: 'pipe',
      }
    );

    if (this.stdinStr) {
      this.process.stdin.setDefaultEncoding('utf8');
      this.process.stdin.write(this.stdinStr);
      this.process.stdin.end();
    }

    const dataListener = data => {
      this.data = data.toString();
      // Uncomment the line below if the process is blocked and you need to see its output
      // console.warn(this.data);
      this.chunks.push(...this.data.split('\n').filter(Boolean));
      if (this.waitForPromise && this.data.includes(this.waitForText)) {
        this.process.stdout.off('data', dataListener);
        this.waitForPromise();
      }
    };
    this.process.stdout.on('data', dataListener);

    this.exitCode = new Promise(res => {
      // Uncomment to debug stderr
      //this.process.stderr.on('data', data => {
      //  console.log('climock.stderr:  ', data.toString());
      //});
      this.process.on('exit', code => res(code));
    });

    return this;
  }

  async waitFor(text: string): Promise<void> {
    this.waitForText = text;
    return new Promise(r => (this.waitForPromise = r));
  }

  output() {
    return this.data;
  }

  buffer() {
    return this.chunks;
  }
}
