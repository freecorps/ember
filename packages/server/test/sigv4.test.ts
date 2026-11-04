import { describe, expect, it } from "vitest";
import { base64, EMPTY_SHA256, hex, hmacSha256, presignUrl, sha256HexOf, signRequest, uriEncode } from "../src/sigv4.ts";

// AWS documentation examples (S3 "Signature Calculations for the Authorization Header" and "Query String Auth")
// and the generic SigV4 test suite (get-vanilla*).
const S3_CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const S3_DATE = Date.UTC(2013, 4, 24, 0, 0, 0);
const sigOf = (auth: string) => /Signature=([0-9a-f]{64})/.exec(auth)![1];

describe("HMAC-SHA256 (pure JS)", () => {
  it("matches RFC 4231 test case 2", () => {
    expect(hex(hmacSha256("Jefe", "what do ya want for nothing?"))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
  it("matches RFC 4231 test case 6 (key longer than the block)", () => {
    const key = new Uint8Array(131).fill(0xaa);
    expect(hex(hmacSha256(key, "Test Using Larger Than Block-Size Key - Hash Key First"))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });
  it("agrees with WebCrypto on random inputs", async () => {
    for (let i = 0; i < 20; i++) {
      const key = crypto.getRandomValues(new Uint8Array(1 + ((i * 37) % 150)));
      const msg = crypto.getRandomValues(new Uint8Array((i * 101) % 700));
      const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const want = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
      expect(hex(hmacSha256(key, msg))).toBe(hex(want));
    }
  });
});

describe("SigV4 header auth", () => {
  it("S3 GET Object example (Range header)", () => {
    const h = signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      credentials: S3_CREDS,
      region: "us-east-1",
      date: S3_DATE,
      payloadHash: EMPTY_SHA256,
    });
    expect(sigOf(h.authorization!)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(h.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });

  it("S3 PUT Object example (encoded key, body hash, extra headers)", () => {
    const body = "Welcome to Amazon S3.";
    const h = signRequest({
      method: "PUT",
      url: `https://examplebucket.s3.amazonaws.com/${uriEncode("test$file.text", true)}`,
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      credentials: S3_CREDS,
      region: "us-east-1",
      date: S3_DATE,
      payloadHash: sha256HexOf(body),
    });
    expect(h["x-amz-content-sha256"]).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    expect(sigOf(h.authorization!)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("S3 GET Bucket lifecycle example (valueless query param)", () => {
    const h = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle", credentials: S3_CREDS, region: "us-east-1", date: S3_DATE });
    expect(sigOf(h.authorization!)).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });

  it("S3 GET Bucket (list objects) example (sorted query)", () => {
    const h = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", credentials: S3_CREDS, region: "us-east-1", date: S3_DATE });
    expect(sigOf(h.authorization!)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("generic suite: get-vanilla", () => {
    const h = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      region: "us-east-1",
      service: "service",
      date: Date.UTC(2015, 7, 30, 12, 36, 0),
      omitContentSha256: true,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("SigV4 presigned URLs", () => {
  it("S3 presigned GET example (24 h)", () => {
    const url = presignUrl({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      credentials: S3_CREDS,
      region: "us-east-1",
      date: S3_DATE,
      expiresIn: 86400,
    });
    const u = new URL(url);
    expect(u.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("signs extra headers and keeps existing query params", () => {
    const url = presignUrl({
      method: "PUT",
      url: "https://acct.r2.cloudflarestorage.com/bucket/f/a/b?partNumber=2&uploadId=x%2By",
      headers: { "Content-Type": "image/png", "x-amz-checksum-sha256": base64(new Uint8Array(32)) },
      credentials: S3_CREDS,
      date: S3_DATE,
      expiresIn: 9_999_999,
    });
    const u = new URL(url);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-checksum-sha256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(u.searchParams.get("uploadId")).toBe("x+y");
    expect(u.searchParams.get("partNumber")).toBe("2");
    expect(u.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
  });

  it("is deterministic for the same inputs", () => {
    const a = presignUrl({ method: "GET", url: "https://h/b/k", credentials: S3_CREDS, date: 1e12, expiresIn: 60 });
    expect(presignUrl({ method: "GET", url: "https://h/b/k", credentials: S3_CREDS, date: 1e12, expiresIn: 60 })).toBe(a);
  });

  it("base64 matches btoa", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(base64(b)).toBe(btoa(String.fromCharCode(...b)));
    }
  });
});
