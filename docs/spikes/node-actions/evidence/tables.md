<!-- `node report.mjs` output for results.jsonl as first measured. sheetjs-0.18 (npm xlsx@0.18.5) is not recommended (advisories GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9) and was removed from the spike; exceljs-stream points re-measured with the shipped options are in rerun-shipped.jsonl. -->


#### exceljs.read  (bundle 1434 KiB, gzip 295 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 465 ms | 0.6 s | 105 MB | 348 ms | 224 MB |
| 20,000* | ✅ | 782 ms | 0.96 s | 192 MB |  |  |
| 25,000* | ✅ | 1.0 s | 1.2 s | 236 MB |  |  |
| 30,000* | ❌ OOM | 1.8 s | — s | 262 MB |  |  |
| 50,000 | ❌ OOM | 2.3 s | — s | 334 MB | 1.4 s | 668 MB |

Threshold: fits at 25,000, OOM at 30,000 (* = bisection point).

#### exceljs.write  (bundle 1434 KiB, gzip 295 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 631 ms | 0.73 s | 117 MB | 583 ms | 348 MB |
| 15,000* | ❌ OOM | 1.4 s | — s | 136 MB |  |  |
| 20,000* | ❌ OOM | 1.5 s | — s | 160 MB |  |  |
| 30,000* | ❌ OOM | 1.1 s | — s | 139 MB |  |  |
| 50,000 | ❌ OOM | 1.4 s | — s | 130 MB | 3.0 s | 1443 MB |

Threshold: fits at 10,000, OOM at 15,000 (* = bisection point).

#### exceljs-stream.read  (bundle 2206 KiB, gzip 402 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 478 ms | 0.63 s | 431 MB | 216 ms | 98 MB |
| 50,000 | ✅ | 7.9 s | 7.97 s | 2083 MB | 932 ms | 296 MB |
| 100,000 | ✅ | 31.8 s | 32.01 s | 3993 MB | 1.8 s | 480 MB |
| 200,000 | ❌ crash | 33.0 s | — s | 4390 MB | 3.7 s | 737 MB |

Error: `fetch failed`

#### exceljs-stream.write (neutral build)  (bundle 2353 KiB, gzip 422 KiB, build: neutral)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 160 ms | 0.18 s | 26 MB | 151 ms | 91 MB |
| 50,000 | ✅ | 622 ms | 0.63 s | 68 MB | 633 ms | 134 MB |
| 100,000 | ✅ | 1.2 s | 1.22 s | 81 MB | 1.2 s | 257 MB |
| 200,000 | ✅ | 2.4 s | 2.43 s | 81 MB | 2.4 s | 336 MB |
| 500,000 | ✅ | 6.0 s | 6.15 s | 85 MB | 6.1 s | 517 MB |

#### sheetjs-0.18.read  (bundle 849 KiB, gzip 191 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 361 ms | 0.41 s | 73 MB | 334 ms | 180 MB |
| 30,000* | ✅ | 1.1 s | 1.19 s | 173 MB |  |  |
| 35,000* | ✅ | 1.3 s | 1.41 s | 189 MB |  |  |
| 40,000* | ❌ OOM | 2.7 s | — s | 203 MB |  |  |
| 50,000 | ❌ OOM | 2.0 s | — s | 218 MB | 1.6 s | 552 MB |

Threshold: fits at 35,000, OOM at 40,000 (* = bisection point).

#### sheetjs-0.20.read  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 423 ms | 0.49 s | 73 MB | 394 ms | 181 MB |
| 30,000* | ✅ | 1.3 s | 1.38 s | 170 MB |  |  |
| 35,000* | ✅ | 1.5 s | 1.58 s | 189 MB |  |  |
| 40,000* | ❌ OOM | 2.5 s | — s | 208 MB |  |  |
| 50,000 | ❌ OOM | 2.2 s | — s | 218 MB | 1.9 s | 575 MB |

Threshold: fits at 35,000, OOM at 40,000 (* = bisection point).

#### sheetjs-0.20.readDense  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 336 ms | 0.38 s | 67 MB | 331 ms | 152 MB |
| 30,000* | ✅ | 1.0 s | 1.07 s | 153 MB |  |  |
| 40,000* | ✅ | 1.3 s | 1.41 s | 192 MB |  |  |
| 45,000* | ✅ | 1.6 s | 1.61 s | 209 MB |  |  |
| 50,000 | ❌ OOM | 2.2 s | — s | 218 MB | 1.5 s | 463 MB |

Threshold: fits at 45,000, OOM at 50,000 (* = bisection point).

#### sheetjs-0.20.write  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 189 ms | 0.23 s | 70 MB | 219 ms | 225 MB |
| 20,000* | ✅ | 412 ms | 0.46 s | 133 MB |  |  |
| 25,000* | ✅ | 500 ms | 0.55 s | 158 MB |  |  |
| 30,000* | ❌ OOM | 983 ms | — s | 194 MB |  |  |
| 50,000 | ❌ OOM | 1.5 s | — s | 281 MB | 1.0 s | 783 MB |

Threshold: fits at 25,000, OOM at 30,000 (* = bisection point).

#### pdf-lib.generate  (bundle 806 KiB, gzip 212 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10 | ✅ | 24 ms | 0.05 s | 0 MB | 24 ms | 49 MB |
| 100 | ✅ | 101 ms | 0.17 s | 39 MB | 95 ms | 93 MB |
| 1,000 | ✅ | 735 ms | 0.86 s | 132 MB | 758 ms | 345 MB |
| 2,000* | ✅ | 1.7 s | 1.79 s | 195 MB |  |  |
| 2,500* | ❌ OOM | 1.7 s | — s | 132 MB |  |  |
| 3,000* | ❌ OOM | 1.7 s | — s | 132 MB |  |  |
| 5,000 | ❌ OOM | 1.6 s | — s | 132 MB | 4.1 s | 886 MB |

Threshold: fits at 2,000, OOM at 2,500 (* = bisection point).

#### pdf-lib.stamp  (bundle 806 KiB, gzip 212 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 100 | ✅ | 54 ms | 0.09 s | 17 MB | 51 ms | 72 MB |
| 1,000 | ✅ | 321 ms | 0.34 s | 91 MB | 334 ms | 204 MB |
| 5,000 | ✅ | 1.7 s | 1.3 s | 180 MB | 1.7 s | 457 MB |

#### pdfjs.text  (bundle 3358 KiB, gzip 706 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10 | ✅ | 28 ms | 0.05 s | 9 MB | 32 ms | 52 MB |
| 100 | ✅ | 81 ms | 0.15 s | 15 MB | 114 ms | 67 MB |
| 1,000 | ✅ | 634 ms | 0.85 s | 53 MB | 813 ms | 207 MB |
| 3,000* | ✅ | 2.0 s | 2.3 s | 102 MB |  |  |
| 4,000* | ✅ | 2.8 s | 3.26 s | 132 MB |  |  |
| 4,500* | ✅ | 3.4 s | 3.99 s | 140 MB |  |  |
| 5,000 | ❌ OOM | 10.6 s | — s | 149 MB | 4.5 s | 425 MB |

Threshold: fits at 4,500, OOM at 5,000 (* = bisection point).

#### jszip.zip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 5.7 s | 2.21 s | 92 MB | 933 ms | 222 MB |
| 3,000* | ✅ | 18.8 s | 7.87 s | 206 MB |  |  |
| 4,000* | ✅ | 25.3 s | 10.6 s | 235 MB |  |  |
| 4,500* | ❌ OOM | 1.2 s | — s | 133 MB |  |  |
| 5,000 | ❌ OOM | 1.3 s | — s | 130 MB | 4.8 s | 557 MB |

Threshold: fits at 4,000, OOM at 4,500 (* = bisection point).

#### fflate.zip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 465 ms | 0.52 s | 127 MB | 537 ms | 162 MB |
| 5,000 | ✅ | 2.3 s | 2.39 s | 248 MB | 2.8 s | 385 MB |
| 20,000 | ✅ | 9.4 s | 9.49 s | 777 MB | 11.3 s | 984 MB |

#### papaparse.parse  (bundle 32 KiB, gzip 10 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 48 ms | 0.06 s | 49 MB | 36 ms | 72 MB |
| 100,000 | ✅ | 388 ms | 0.39 s | 411 MB | 320 ms | 336 MB |
| 150,000* | ❌ OOM | 901 ms | — s | 575 MB |  |  |
| 200,000* | ❌ OOM | 860 ms | — s | 695 MB |  |  |
| 300,000* | ❌ OOM | 724 ms | — s | 995 MB |  |  |
| 500,000 | ❌ OOM | 405 ms | — s | 1596 MB | 1.6 s | 1231 MB |

Threshold: fits at 100,000, OOM at 150,000 (* = bisection point).

#### papaparse.stream  (bundle 32 KiB, gzip 10 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 57 ms | 0.1 s | 19 MB | 44 ms | 50 MB |
| 100,000 | ✅ | 424 ms | 0.5 s | 47 MB | 344 ms | 53 MB |
| 500,000 | ✅ | 2.1 s | 2.2 s | 39 MB | 1.7 s | 89 MB |
| 1,000,000 | ✅ | 4.2 s | 4.31 s | 45 MB | 3.3 s | 157 MB |

#### jszip.unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 5.6 s | 0.66 s | 33 MB | 177 ms | 88 MB |
| 5,000 | ✅ | 27.2 s | 2.45 s | 124 MB | 830 ms | 199 MB |
| 20,000 | ✅ | 108.2 s | 8.76 s | 406 MB | 3.3 s | 485 MB |

#### fflate.unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 115 ms | 0.13 s | 52 MB | 89 ms | 84 MB |
| 5,000 | ✅ | 501 ms | 0.53 s | 216 MB | 416 ms | 237 MB |
| 20,000 | ✅ | 2.0 s | 2.06 s | 827 MB | 1.6 s | 753 MB |

#### fflate.stream-unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 169 ms | 0.2 s | 77 MB | 151 ms | 126 MB |
| 5,000 | ✅ | 891 ms | 1.23 s | 83 MB | 671 ms | 135 MB |
| 20,000 | ✅ | 3.7 s | 5.45 s | 108 MB | 2.8 s | 186 MB |

#### exceljs-stream.readSheetsLast  (bundle 2211 KiB, gzip 403 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 262 ms | 0.31 s | 48 MB | 215 ms | 130 MB |
| 50,000 | ✅ | 978 ms | 1.06 s | 75 MB | 945 ms | 273 MB |
| 100,000 | ✅ | 3.1 s | 3.92 s | 90 MB | 1.8 s | 453 MB |
| 200,000 | ✅ | 3.9 s | 4.29 s | 154 MB | 3.5 s | 613 MB |
| 350,000* | ✅ | 34.0 s | 37.22 s | 153 MB |  |  |
| 390,000* | ❌ OOM | 1.5 s | — s | 158 MB |  |  |
| 425,000* | ❌ OOM | 1.5 s | — s | 159 MB |  |  |
| 500,000 | ❌ OOM | 2.3 s | — s | 145 MB | 8.9 s | 1338 MB |

Threshold: fits at 350,000, OOM at 390,000 (* = bisection point).
