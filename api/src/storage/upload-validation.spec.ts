import { extensionOf, validateUpload } from './upload-validation';

describe('extensionOf', () => {
  it.each([
    ['podcast.mp3', 'mp3'],
    ['UPPER.WAV', 'wav'],
    ['archive.tar.ogg', 'ogg'],
    ['noextension', ''],
    ['.hidden', ''],
  ])('%s -> %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('validateUpload', () => {
  it('accepts allowed extensions with audio MIME types', () => {
    expect(validateUpload('a.mp3', 'audio/mpeg')).toBeNull();
    expect(validateUpload('a.wav', 'audio/wav')).toBeNull();
    expect(validateUpload('a.m4a', 'audio/mp4')).toBeNull();
    expect(validateUpload('a.flac', 'audio/flac')).toBeNull();
  });

  it('accepts generic MIME types (curl default) for allowed extensions', () => {
    expect(validateUpload('a.mp3', 'application/octet-stream')).toBeNull();
    expect(validateUpload('a.webm', 'video/webm')).toBeNull();
    expect(validateUpload('a.ogg', 'application/ogg')).toBeNull();
  });

  it('rejects disallowed extensions', () => {
    expect(validateUpload('notes.txt', 'text/plain')).not.toBeNull();
    expect(validateUpload('movie.mp4', 'video/mp4')).not.toBeNull();
    expect(validateUpload('noextension', 'audio/mpeg')).not.toBeNull();
  });

  it('rejects allowed extensions with clearly non-audio MIME types', () => {
    expect(validateUpload('fake.mp3', 'text/html')).not.toBeNull();
    expect(validateUpload('fake.wav', 'application/pdf')).not.toBeNull();
  });
});
