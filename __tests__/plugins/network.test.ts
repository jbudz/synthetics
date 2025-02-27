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

import { Gatherer } from '../../src/core/gatherer';
import { NetworkManager, calculateTimings } from '../../src/plugins/network';
import { Server } from '../utils/server';
import { wsEndpoint } from '../utils/test-config';

describe('network', () => {
  let server: Server;
  beforeAll(async () => {
    server = await Server.create();
  });
  afterAll(async () => {
    await server.close();
  });

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  it('should capture network info', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();
    await driver.page.goto(server.TEST_PAGE);
    const netinfo = await network.stop();
    expect(netinfo.length).toBeGreaterThan(0);
    expect(netinfo[0]).toMatchObject({
      isNavigationRequest: true,
      step: null,
      timestamp: expect.any(Number),
      url: server.TEST_PAGE,
      request: expect.any(Object),
      response: expect.any(Object),
      type: 'Document',
      method: 'GET',
      requestSentTime: expect.any(Number),
      status: 200,
      loadEndTime: expect.any(Number),
      responseReceivedTime: expect.any(Number),
      timings: expect.any(Object),
    });
    await Gatherer.stop();
  });

  it('not include data URL in network info', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();
    await driver.page.goto('data:text/html,<title>Data URI test</title>');
    const netinfo = await network.stop();
    expect(await driver.page.content()).toContain('Data URI test');
    expect(netinfo).toEqual([]);
    await Gatherer.stop();
  });

  it('produce distinct events for redirects', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();
    /**
     * Set up two level of redirects
     */
    server.setRedirect('/route1', '/route2');
    server.setRedirect('/route2', '/route3');
    server.route('/route3', (req, res) => {
      res.end('route3');
    });
    await driver.page.goto(server.PREFIX + '/route1');
    const netinfo = await network.stop();
    expect(netinfo.length).toEqual(3);
    expect(netinfo[0].status).toBe(302);
    expect(netinfo[1].status).toBe(302);
    expect(netinfo[2].status).toBe(200);
    await Gatherer.stop();
  });

  it('measure resource and transfer size', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();
    server.route('/route1', (_, res) => {
      res.end('A'.repeat(10));
    });
    await driver.page.goto(server.PREFIX + '/route1');
    const netinfo = await network.stop();
    expect(netinfo[0]).toMatchObject({
      resourceSize: 10,
      transferSize: expect.any(Number),
    });
    await Gatherer.stop();
  });

  it('timings for aborted requests', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();

    const delayTime = 20;
    server.route('/delay100', async (req, res) => {
      await delay(delayTime);
      res.destroy();
    });
    server.route('/index', async (_, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<script src=${server.PREFIX}/delay100 />`);
    });

    await driver.page.goto(server.PREFIX + '/index');
    await driver.page.waitForLoadState();
    await Gatherer.stop();
    const netinfo = await network.stop();
    expect(netinfo.length).toBe(2);
    expect(netinfo[1]).toMatchObject({
      url: `${server.PREFIX}/delay100`,
      status: 0,
      response: null,
      timings: expect.any(Object),
    });
    expect(netinfo[1].timings.total).toBeGreaterThan(delayTime);
    expect(netinfo[1].timings.total).toEqual(netinfo[1].timings.blocked);
  });

  it('timings for chunked response', async () => {
    const driver = await Gatherer.setupDriver({ wsEndpoint });
    const network = new NetworkManager(driver);
    await network.start();

    const delayTime = 100;
    server.route('/chunked', async (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/javascript',
      });
      res.write('a');
      await delay(delayTime);
      res.write('b');
      await delay(delayTime);
      return res.end('c');
    });
    server.route('/index', async (_, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<script src=${server.PREFIX}/chunked />`);
    });

    await driver.page.goto(server.PREFIX + '/index');
    await driver.page.waitForLoadState();
    await Gatherer.stop();
    const netinfo = await network.stop();
    expect(netinfo.length).toBe(2);
    expect(netinfo[1]).toMatchObject({
      url: `${server.PREFIX}/chunked`,
      status: 200,
      response: expect.any(Object),
      timings: expect.any(Object),
    });
    expect(netinfo[1].timings.total).toBeGreaterThan(delayTime);
  });

  describe('waterfall timing calculation', () => {
    const getEvent = () => {
      return {
        response: {
          // requestTime is in seconds, rest of the timing.* is in milliseconds
          timing: {
            requestTime: 1,
            proxyStart: -1,
            proxyEnd: -1,
            dnsStart: 0.1,
            dnsEnd: 26,
            connectStart: 26,
            connectEnd: 92.669,
            sslStart: 40,
            sslEnd: 92,
            sendStart: 94,
            sendEnd: 95,
            receiveHeadersEnd: 2350,
          },
        },
        requestSentTime: 1,
        loadEndTime: 3,
        responseReceivedTime: 2,
      };
    };

    it('calculate timings for a request event', () => {
      const record = getEvent();
      const timings = calculateTimings(record as any);
      expect(timings).toEqual({
        blocked: 0.09999999999998899,
        queueing: -1,
        proxy: -1,
        dns: 25.900000000000034,
        ssl: 52.00000000000004,
        connect: 66.66899999999987,
        send: 0.9999999999998899,
        wait: 905,
        receive: 1000,
        total: 2000,
      });
    });

    it('when some resource timing data is unavailable', () => {
      const record = getEvent();
      Object.assign(record.response.timing, {
        connectEnd: -1,
        dnsStart: -1,
      });
      const timings = calculateTimings(record as any);
      expect(timings).toEqual({
        blocked: 26.00000000000002,
        connect: -1,
        dns: -1,
        proxy: -1,
        queueing: -1,
        receive: 1000,
        send: 0.9999999999998899,
        ssl: 52.00000000000004,
        total: 2000,
        wait: 905,
      });
    });

    it('when complete resource timing is not available', () => {
      const record = getEvent();
      record.response.timing = null;
      const timings = calculateTimings(record as any);
      expect(timings).toEqual({
        blocked: 1000,
        connect: -1,
        dns: -1,
        proxy: -1,
        queueing: -1,
        receive: 1000,
        send: -1,
        ssl: -1,
        total: 2000,
        wait: -1,
      });
    });
  });
});
