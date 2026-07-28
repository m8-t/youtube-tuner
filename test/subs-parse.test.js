import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractContinuationToken,
  extractInnertubeConfig,
  extractSubscribedChannelNames,
  parseSubscriptionContinuation,
} from '../src/subs-parse.js';

test('extractSubscribedChannelNames keeps existing renderer cases', () => {
  const html = `<script>
    var ytInitialData = {
      "one":{"channelRenderer":{"title":{"simpleText":" Channel A "}}},
      "two":{"gridChannelRenderer":{"title":{"runs":[{"text":"Channel "},{"text":"B"}]}}},
      "duplicate":{"channelRenderer":{"title":{"simpleText":"Channel A"}}},
      "malformed":{"channelRenderer":{"title":null}}
    };
  </script>`;

  assert.deepEqual(extractSubscribedChannelNames(html), [
    'Channel A',
    'Channel B',
  ]);
  assert.deepEqual(extractSubscribedChannelNames(null), []);
});

test('extracts InnerTube config and the initial continuation from HTML', () => {
  const context = { client: { clientName: 'WEB', clientVersion: '1.2.3' } };
  const html = `<script>
    ytcfg.set(${JSON.stringify({ INNERTUBE_API_KEY: 'key-123' })});
    ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: context })});
    var ytInitialData = {
      "continuations":[
        {"nextContinuationData":{"continuation":"next-page"}}
      ]
    };
  </script>`;

  assert.deepEqual(extractInnertubeConfig(html), {
    apiKey: 'key-123',
    context,
  });
  assert.equal(extractContinuationToken(html), 'next-page');
});

test('parses a small InnerTube continuation response', () => {
  const response = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            {
              gridChannelRenderer: {
                title: { simpleText: 'Channel C' },
              },
            },
            {
              channelRenderer: {
                title: { runs: [{ text: 'Channel D' }] },
              },
            },
            {
              continuationItemRenderer: {
                continuationEndpoint: {
                  continuationCommand: { token: 'next-token' },
                },
              },
            },
          ],
        },
      },
    ],
  };

  assert.deepEqual(parseSubscriptionContinuation(response), {
    names: ['Channel C', 'Channel D'],
    continuation: 'next-token',
  });
});
