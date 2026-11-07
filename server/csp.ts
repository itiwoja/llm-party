/** `npm start` の CSP（12）。生成した画像・音声は認証ヘッダーが要るので fetch で取り、blob: の URL で見せる */
export const PRODUCTION_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:";
