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

export const BLUE_GREEN_RATIO = 0.8;
export const blueGreenHeaderContextKey = 'x-blue-green-context';
export const blueGreenQueryStringParam = `blue_green`;

const setCookieRequest = (location: string, blueGreenContext: string) => {
  const cookieRequest = {
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
  };
  console.log('setCookieRequest: %j', cookieRequest);
  return cookieRequest;
};

const getContextCookie = (headers: CloudFrontHeaders) => {
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

const getContextHeader = (headers: CloudFrontHeaders) => {
  const contextHeader = headers[blueGreenHeaderContextKey];
  if (!contextHeader) {
    console.log('No context header found');
    return null;
  }
  const result = contextHeader[0].value === 'blue' ? 'blue' : 'green';
  console.log('getContextHeader: %j', result);
  return result;
};

const getContextQueryString = (querystring: string) => {
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

const getRandomContext = () => {
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

  let blueGreenContext: 'blue' | 'green' = 'blue';

  const request: CloudFrontRequest = event.Records[0].cf.request;
  const { headers, querystring, uri } = request;

  const contextQueryString = getContextQueryString(querystring);
  const contextHeader = getContextHeader(headers);
  const contextCookie = getContextCookie(headers);

  if (contextQueryString) {
    blueGreenContext = contextQueryString;
  } else if (contextHeader) {
    blueGreenContext = contextHeader;
  } else if (contextCookie) {
    blueGreenContext = contextCookie;
  } else {
    blueGreenContext = getRandomContext();
  }

  if (uri === '/' && blueGreenContext !== contextCookie) {
    return callback(null, setCookieRequest(uri, blueGreenContext));
  }

  headers[blueGreenHeaderContextKey] = [
    {
      key: blueGreenHeaderContextKey,
      value: blueGreenContext,
    },
  ];

  console.log('returned request: %j', request);
  return callback(null, { ...request, headers: { ...request.headers, ...headers } });
};
