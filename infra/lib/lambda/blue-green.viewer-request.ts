import {
  Callback,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
  Context,
} from 'aws-lambda';
import * as qs from 'querystring';

export const BLUE_GREEN_RATIO = 0.8;
export const blueGreenHeaderContextKey = 'x-blue-green-context';
export const blueGreenQueryStringParam = `blue_green`;

const setCookieResponse = (location: string, blueGreenContext: string) => ({
  status: '302',
  statusDescription: 'Found',
  headers: {
    location: [
      {
        key: 'location',
        value: location,
      },
    ],
    'set-cookie': [
      {
        key: 'set-cookie',
        value: `${blueGreenHeaderContextKey}=${blueGreenContext}; Secure; HttpOnly`,
      },
    ],
  },
});

/**
 * This function ensures that the x-blue-green-context header is set for the next
 * leg of the CloudFront journey, which is "Origin Request". This leg, known as
 * "Viewer Request" allows us to inspect the request and modify it to fine-tune
 * caching. We are adding this header to the cache, so that the blue files will
 * be cached for "blue" group and likewise for "green".
 *
 * If the header already exists (from the original response), it is respected,
 * otherwise blue or green is assigned using the ratio of BLUE_GREEN_RATIO blue
 * to green. Once the request is assigned blue or green, the header is written
 * (if it doesn't already exist)
 */
export const handler: CloudFrontRequestHandler = (
  event: CloudFrontRequestEvent,
  context: Context,
  callback: Callback<CloudFrontRequestResult>
) => {
  console.log('event: %j', event);

  const request: CloudFrontRequest = event.Records[0].cf.request;
  const headers = request.headers;
  const querystringParams = qs.parse(`${request.querystring}`);

  let blueGreenContext: 'blue' | 'green' = 'blue';
  const contextHeader = headers[blueGreenHeaderContextKey];
  const contextCookie = (headers.cookie || []).find((cookie) =>
    cookie.value.includes(blueGreenHeaderContextKey)
  );
  const contextQueryStringParam = querystringParams[blueGreenQueryStringParam];

  if (contextHeader) {
    blueGreenContext = contextHeader[0].value === 'blue' ? 'blue' : 'green';
    console.log('Existing header: %j', blueGreenContext);
  } else if (contextQueryStringParam) {
    blueGreenContext = contextQueryStringParam === 'blue' ? 'blue' : 'green';
    console.log('Existing query string: %j', blueGreenContext);
    // Update querystring for origin request
    delete querystringParams[blueGreenQueryStringParam];
    request.querystring = qs.stringify(querystringParams);
  } else if (contextCookie) {
    blueGreenContext = contextCookie.value.includes(`${blueGreenHeaderContextKey}=blue`)
      ? 'blue'
      : 'green';
    console.log('Existing cookie: %j', blueGreenContext);
  } else {
    blueGreenContext = Math.random() < BLUE_GREEN_RATIO ? 'blue' : 'green';
    console.log('Randomly chosen header: %j', blueGreenContext);
    // redirect and set cookie
    const redirectResponse = setCookieResponse(request.uri, blueGreenContext);
    console.log('Set-cookie redirect: %j', redirectResponse);
    return callback(null, redirectResponse);
  }

  headers[blueGreenHeaderContextKey] = [
    {
      key: blueGreenHeaderContextKey,
      value: blueGreenContext,
    },
  ];

  console.log('response: %j', request);
  return callback(null, { ...request, headers: { ...request.headers, ...headers } });
};
