import { formatTimestamp, toSrt, toVtt } from './srt.util';

const SEGMENTS = [
  { id: 0, start: 0, end: 4.9, text: 'Hello and welcome.' },
  { id: 1, start: 4.9, end: 9.88, text: 'Second segment.' },
];

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00:00,000'],
    [4.9, '00:00:04,900'],
    [9.88, '00:00:09,880'],
    [59.999, '00:00:59,999'],
    [60, '00:01:00,000'],
    [3661.5, '01:01:01,500'],
    [36000.001, '10:00:00,001'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTimestamp(seconds, ',')).toBe(expected);
  });

  it('uses a dot separator for VTT', () => {
    expect(formatTimestamp(4.9, '.')).toBe('00:00:04.900');
  });

  it('carries millisecond rounding into the seconds field', () => {
    expect(formatTimestamp(59.9996, ',')).toBe('00:01:00,000');
  });
});

describe('toSrt', () => {
  it('renders numbered blocks with comma timestamps', () => {
    expect(toSrt(SEGMENTS)).toBe(
      '1\n00:00:00,000 --> 00:00:04,900\nHello and welcome.\n\n' +
        '2\n00:00:04,900 --> 00:00:09,880\nSecond segment.\n',
    );
  });

  it('renders an empty string for no segments', () => {
    expect(toSrt([])).toBe('');
  });
});

describe('toVtt', () => {
  it('starts with the WEBVTT header and uses dot timestamps', () => {
    const vtt = toVtt(SEGMENTS);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:04.900 --> 00:00:09.880');
    expect(vtt).not.toContain(',');
  });
});
