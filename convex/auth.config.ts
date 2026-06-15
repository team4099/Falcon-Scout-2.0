const siteUrl = process.env.CONVEX_SITE_URL;

export default {
  providers: [
    {
      // Convex Auth issues JWTs with the site URL as the issuer.
      // The Convex platform fetches the JWKS from this domain to validate
      // every JWT before calling getUserIdentity() in any query/mutation.
      domain: siteUrl,
      applicationID: "convex",
    },
  ],
};
