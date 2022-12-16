import {
  Callback,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
  Context,
} from 'aws-lambda';

export const BLUE_GREEN_RATIO = 0.8;
export const blueGreenHeaderContextKey = 'x-blue-green-context';

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

  let blueGreenContext: 'blue' | 'green' = 'blue';
  const contextHeader = headers[blueGreenHeaderContextKey];

  if (contextHeader) {
    blueGreenContext = contextHeader[0].value === 'blue' ? 'blue' : 'green';
    console.log('Existing header: %j', blueGreenContext);
  } else {
    blueGreenContext = Math.random() < BLUE_GREEN_RATIO ? 'blue' : 'green';
    console.log('Randomly chosen header: %j', blueGreenContext);
  }

  headers[blueGreenHeaderContextKey] = [
    {
      key: blueGreenHeaderContextKey,
      value: blueGreenContext,
    },
  ];

  console.log('response: %j', request);
  callback(null, { ...request, headers: { ...request.headers, ...headers } });
};
