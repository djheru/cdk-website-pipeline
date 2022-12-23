import {
  Callback,
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
  Context,
} from 'aws-lambda';
import * as qs from 'querystring';

type RequestBlueGreenContext = 'blue' | 'green' | null;
type BlueGreenContext = 'blue' | 'green' | null;

export const BLUE_GREEN_RATIO = 0.8;
export const blueGreenHeaderContextKey = 'x-blue-green-context';
export const blueGreenQueryStringParam = `blue_green`;

const setContextHeader = (
  headers: CloudFrontHeaders,
  value: BlueGreenContext,
  key: string = blueGreenHeaderContextKey
) => ({
  ...headers,
  [blueGreenHeaderContextKey]: [{ key, value: `${value}` }],
});

const setCookieRequest = (location: string, blueGreenContext: BlueGreenContext) => {
  const cookieRequest = {
    status: '302',
    statusDescription: 'Found',
    headers: setContextHeader(
      {
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
      blueGreenContext
    ),
  };
  console.log('setCookieRequest: %j', cookieRequest);
  return cookieRequest;
};

const getContextCookie = (headers: CloudFrontHeaders): RequestBlueGreenContext => {
  const contextCookie = (headers.cookie || []).find((cookie) =>
    cookie.value.includes(blueGreenHeaderContextKey)
  );
  if (!contextCookie) {
    console.log('No context cookie found');
    return null;
  }
  const result = contextCookie.value.includes(`${blueGreenHeaderContextKey}=blue`)
    ? 'blue'
    : 'green';
  console.log('getContextCookie: %j', result);
  return result;
};

const getContextHeader = (headers: CloudFrontHeaders): RequestBlueGreenContext => {
  const contextHeader = headers[blueGreenHeaderContextKey];
  if (!contextHeader) {
    console.log('No context header found');
    return null;
  }
  const result = contextHeader[0].value === 'blue' ? 'blue' : 'green';
  console.log('getContextHeader: %j', result);
  return result;
};

const getContextQueryString = (querystring: string): RequestBlueGreenContext => {
  const querystringParams = qs.parse(`${querystring}`);
  const contextQueryStringParam = querystringParams[blueGreenQueryStringParam];
  if (!contextQueryStringParam) {
    console.log('No context querystring found');
    return null;
  }
  const result = contextQueryStringParam === 'blue' ? 'blue' : 'green';
  console.log('getContextQueryString: %j', result);
  return result;
};

const getRandomContext = (): BlueGreenContext => {
  const result = Math.random() < BLUE_GREEN_RATIO ? 'blue' : 'green';
  console.log('getRandomContext: %j', result);
  return result;
};

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

  let blueGreenContext: BlueGreenContext = 'blue';
  let headers: CloudFrontHeaders;

  const request: CloudFrontRequest = event.Records[0].cf.request;
  const { headers: requestHeaders, querystring, uri } = request;

  headers = { ...requestHeaders };

  const contextQueryString = getContextQueryString(querystring);
  const contextHeader = getContextHeader(headers);
  const contextCookie = getContextCookie(headers);
  const randomContext = getRandomContext();

  const requestContext = [contextQueryString, contextHeader, contextCookie].find(
    (ctx: string | null) => ctx !== null
  ) as RequestBlueGreenContext;

  blueGreenContext = requestContext || randomContext;

  setContextHeader(headers, blueGreenContext);

  if (uri === '/' && blueGreenContext !== contextCookie) {
    return callback(null, setCookieRequest(uri, blueGreenContext));
  }

  const result = { ...request, headers: { ...request.headers, ...headers } };
  console.log('returned request: %j', result);
  return callback(null, result);
};
