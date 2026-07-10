import pytest

from transcriber import merge_chunks, offset_segments, plan_chunks, shape_segments


class TestPlanChunks:
    def test_exact_multiple(self):
        assert plan_chunks(600, 300) == [(0.0, 300), (300.0, 300)]

    def test_short_tail_chunk(self):
        assert plan_chunks(650, 300) == [(0.0, 300), (300.0, 300), (600.0, 50)]

    def test_single_chunk_when_shorter_than_chunk_size(self):
        assert plan_chunks(120, 300) == [(0.0, 120)]

    def test_zero_duration(self):
        assert plan_chunks(0, 300) == []

    def test_chunks_cover_full_duration_without_overlap(self):
        chunks = plan_chunks(1234.56, 300)
        assert chunks[0][0] == 0.0
        for (prev_start, prev_len), (next_start, _) in zip(chunks, chunks[1:], strict=False):
            assert prev_start + prev_len == pytest.approx(next_start)
        last_start, last_len = chunks[-1]
        assert last_start + last_len == pytest.approx(1234.56)


class TestOffsetSegments:
    def test_shifts_start_and_end(self):
        raw = [(0.0, 4.0, "a"), (4.0, 9.5, "b")]
        assert offset_segments(raw, 300.0) == [
            (300.0, 304.0, "a"),
            (304.0, 309.5, "b"),
        ]

    def test_zero_offset_is_identity(self):
        raw = [(1.0, 2.0, "a")]
        assert offset_segments(raw, 0.0) == raw


class TestMergeChunks:
    def test_merges_with_offsets_and_stays_monotonic(self):
        chunk_results = [
            (0.0, [(0.0, 4.0, "one"), (4.0, 299.0, "two")]),
            (300.0, [(0.5, 3.0, "three")]),
            (600.0, [(1.0, 42.0, "four")]),
        ]

        merged = merge_chunks(chunk_results)
        segments = shape_segments(merged)

        assert [s["id"] for s in segments] == [0, 1, 2, 3]
        assert [s["start"] for s in segments] == [0.0, 4.0, 300.5, 601.0]
        # Global timestamps must be monotonically non-decreasing.
        starts = [s["start"] for s in segments]
        assert starts == sorted(starts)
        assert all(s["end"] > s["start"] for s in segments)

    def test_empty_chunks_are_fine(self):
        merged = merge_chunks([(0.0, []), (300.0, [(0.0, 1.0, "only")])])
        assert merged == [(300.0, 301.0, "only")]
