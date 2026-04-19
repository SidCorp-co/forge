# Contributing to jarvis-agents

Cảm ơn bạn quan tâm. Dự án đang ở giai đoạn alpha — mọi feedback đều giá trị.

## Trước khi bắt đầu

- Đọc [Code of Conduct](CODE_OF_CONDUCT.md).
- Check issue tồn tại chưa trước khi mở cái mới.
- Với feature lớn: mở **discussion** hoặc issue `proposal` trước khi code.

## Quy trình đóng góp

1. Fork repo, tạo branch từ `main`: `git checkout -b feat/xyz` hoặc `fix/xyz`.
2. Code + test. CI phải pass local trước khi push.
3. Commit theo [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add X` — feature mới
   - `fix: Y` — bug fix
   - `docs: Z` — chỉ docs
   - `refactor:`, `test:`, `chore:`, `perf:`
4. Mở PR, fill template.
5. Một maintainer review trong 3 ngày làm việc.

## Coding standards

- Lint + format phải pass CI.
- Test coverage không giảm.
- Breaking change → ghi rõ trong PR description + update CHANGELOG.

## Báo bug

Dùng [issue template bug](.github/ISSUE_TEMPLATE/bug_report.yml). Tối thiểu cần:
- Phiên bản dùng
- Cách reproduce
- Expected vs actual

## Đề xuất feature

Dùng [issue template feature](.github/ISSUE_TEMPLATE/feature_request.yml). Mô tả **problem** trước, đừng mô tả **solution** ngay.

## Security

**Không** mở public issue cho lỗ hổng bảo mật. Xem [SECURITY.md](SECURITY.md).

## License

Khi submit code, bạn đồng ý contribute dưới [Apache-2.0](LICENSE).
