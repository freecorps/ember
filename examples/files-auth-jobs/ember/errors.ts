// The app's error codes: thrown by the public functions with their message, typed on the client
// (`isError(e, api.files.generateUploadUrl, "FileTooLarge")`). Helpers and internal functions may throw plain errors.
import { defineErrors, v } from "@freecorps/ember-server";

export const errors = defineErrors({
  InvalidFileSize: { message: "Invalid file size" },
  FileTooLarge: { data: v.object({ max: v.number() }), message: "Files are limited to 5 MiB in this example" },
  NotUploaded: { message: "The file was not uploaded" },
  UploadNotFound: { message: "No such upload" },
  RateNotReplicated: { data: v.object({ rateId: v.string() }), message: (d: { rateId: string }) => `rate ${d.rateId} has not reached this shard yet` },
});
