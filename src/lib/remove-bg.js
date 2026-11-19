// Background removal for `remove-bg`.
// remove.bg's API moved to Leonardo.Ai on December 1, 2026, so this calls Leonardo's
// sync endpoint with the `remove-bg` model:
// https://docs.leonardo.ai/docs/migrate-from-the-removebg-api-to-leonardoai

export const LEONARDO_SYNC_URL = 'https://cloud.leonardo.ai/api/rest/v2/generationssync';

// Returns the cutout as PNG bytes. Throws an Error with a readable message on failure.
export async function removeBackground(imageBuffer, apiKey) {
  const response = await fetch(LEONARDO_SYNC_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'remove-bg',
      // Like remove.bg, keep nothing in the Leonardo library.
      ephemeral: true,
      parameters: {
        size: 'auto',
        format: 'png',
        guidances: {
          image_reference: [{ image: { type: 'BASE64', data: imageBuffer.toString('base64') } }],
        },
      },
    }),
  });

  // Leonardo always answers with JSON and often reports errors as HTTP 200 with errors[].
  const data = await response.json().catch(() => ({}));
  const url = data.results?.[0]?.url;
  if (!url) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid API key. Use a Leonardo.Ai API key (remove.bg keys no longer work)');
    }
    throw new Error(data.errors?.[0]?.message || data.error || `API request failed (HTTP ${response.status})`);
  }

  const image = await fetch(url);
  if (!image.ok) {
    throw new Error(`Could not download the result (HTTP ${image.status})`);
  }
  return Buffer.from(await image.arrayBuffer());
}
