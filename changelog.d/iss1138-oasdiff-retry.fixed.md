**One GitHub hiccup no longer fails a deploy.** The core image's build retries the pinned oasdiff download after a 5xx, a 429 or a network error, and its final failure names every attempt.
