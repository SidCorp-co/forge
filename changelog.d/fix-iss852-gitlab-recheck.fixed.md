**GitLab merges stop failing on stale conflicts.** A merge refused on a stale first reading is read again after GitLab's recheck, and refused only when that read agrees (ISS-852).
