import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serve } from "./_serve.js";

export default serve({
  async run() {
    const s3 = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } });
    const put = await s3.send(new PutObjectCommand({ Bucket: "b", Key: "k.txt", Body: "hello", ContentType: "text/plain" }));
    const got = await s3.send(new GetObjectCommand({ Bucket: "b", Key: "k.txt" }));
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: "k.txt" }), { expiresIn: 60 });
    return { etag: put.ETag, body: await got.Body.transformToString(), signed: url.includes("X-Amz-Signature") };
  },
});
