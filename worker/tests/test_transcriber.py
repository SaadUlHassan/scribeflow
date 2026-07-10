from transcriber import build_transcript, shape_segments


def test_shape_segments_rounds_and_renumbers():
    raw = [
        (0.0, 4.24999, " Hello and welcome. "),
        (4.25, 9.8765, " Today we discuss things."),
    ]

    segments = shape_segments(raw)

    assert segments == [
        {"id": 0, "start": 0.0, "end": 4.25, "text": "Hello and welcome."},
        {"id": 1, "start": 4.25, "end": 9.88, "text": "Today we discuss things."},
    ]


def test_shape_segments_empty():
    assert shape_segments([]) == []


def test_build_transcript_joins_text_and_rounds_duration():
    segments = [
        {"id": 0, "start": 0.0, "end": 1.0, "text": "One."},
        {"id": 1, "start": 1.0, "end": 2.0, "text": "Two."},
    ]

    transcript = build_transcript(segments, language="en", duration=2.00499)

    assert transcript == {
        "text": "One. Two.",
        "language": "en",
        "duration": 2.0,
        "segments": segments,
    }
