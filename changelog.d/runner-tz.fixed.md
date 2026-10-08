**macOS and Windows runners now read when a usage limit resets.** The printed reset is parsed in its own time zone in Rust, the same way it is on Linux, instead of by GNU `date -d`.
