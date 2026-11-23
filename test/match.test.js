import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestMatch, parseVideoId } from '../src/match.js';
import { processSubdlResults, toWebVtt } from '../src/subdl.js';

const movie = parseVideoId('movie', 'tt1234567');
const episode = parseVideoId('series', 'tt1234567:2:3');

function score(filename, ...releases) {
  return bestMatch({ behaviorHints: { filename } }, [{ releases }], movie)?.score;
}

test('a subtitle that lists two resolutions matches either YTS.AG stream', () => {
  const label = '1080p - 720p YTS.AG';
  assert.equal(score('Movie.2024.1080p.BluRay.x264-YTS.AG.mp4', label), 1);
  assert.equal(score('Movie.2024.720p.BluRay.x264-YTS.AG.mp4', label), 1);
  assert.equal(score('Movie.2024.2160p.BluRay.x264-YTS.AG.mp4', label), undefined);
  assert.equal(score('Movie.2024.1080p.BluRay.x264-SPARKS.mp4', label), undefined);
});

test('recognizes both named release groups while keeping incompatible versions unmarked', () => {
  const label = 'The Odyssey 2026 4k - 1080p - 720p Bluray Atmos x264 CiNEPHiLES & yts (SyncFIX)';
  assert.equal(score('The.Odyssey.2026.2160p.UHD.BluRay.Remux.HDR.HEVC-CiNEPHiLES.mkv', label), 1);
  assert.equal(score('The.Odyssey.2026.1080p.BluRay.x264-[YTS.BZ].mp4', label), 1);
  assert.equal(score('The.Odyssey.2026.1080p.WEBRip.x264-[YTS.BZ].mp4', label), undefined);
  assert.equal(score('The.Odyssey.2026.1080p.TELESYNC.x264-CiNEPHiLES.mkv', label), undefined);
  assert.equal(score('The.Odyssey.2026.1080p.BluRay.x264-OTHERGROUP.mkv', label), undefined);
});

test('an exact filename beats the same release group', () => {
  assert.equal(score('The.Movie.2024.1080p.BluRay.x264-YTS.AG.mp4',
    '1080p YTS.AG', 'the_movie_2024_1080p_bluray_x264-yts.ag.Greek.srt'), 2);
  assert.equal(score('1080p YTS.AG', '1080p YTS.AG'), 1);
  assert.equal(score('1080p', '1080p'), undefined);
});

test('incompatible source, cut, and frame-rate evidence veto a release match', () => {
  assert.equal(score('Movie.2024.1080p.WEB-DL.x264-YTS.AG', '1080p BluRay YTS.AG'), undefined);
  assert.equal(score('Movie.2024.1080p.Extended.Cut.BluRay-YTS.AG', '1080p BluRay YTS.AG'), undefined);
  assert.equal(score('Movie.2024.1080p.25fps.BluRay-YTS.AG', '1080p 23.976fps BluRay YTS.AG'), undefined);
});

test('uses display text as a fallback when no filename hint is present', () => {
  const stream = { name: '1080p', title: 'Example film · YTS.AG' };
  assert.equal(bestMatch(stream, [{ releases: ['1080p - 720p YTS.AG'] }], movie)?.score, 1);
  const hinted = { ...stream, behaviorHints: { filename: 'Movie.1080p-SPARKS.mp4' } };
  assert.equal(bestMatch(hinted, [{ releases: ['1080p - 720p YTS.AG'] }], movie), null);
});

test('series rejects other episodes and multi-episode video files', () => {
  const subs = [{ releases: ['1080p YTS.AG'] }];
  for (const filename of ['Series.S02E04.1080p-YTS.AG.mkv', 'Series.S02E03E04.1080p-YTS.AG.mkv']) {
    assert.equal(bestMatch({ behaviorHints: { filename } }, subs, episode), null);
  }
  assert.equal(bestMatch({ behaviorHints: { filename: 'Series.S02E03.1080p-YTS.AG.mkv' } }, subs, episode)?.score, 1);
  assert.equal(parseVideoId('series', 'tt1234567'), null);
  assert.equal(parseVideoId('movie', 'tvdb:123'), null);
});

test('SubDL pack handling only selects the requested Greek episode', () => {
  const file = (episodeNumber, language) => ({
    episode: episodeNumber,
    name: `Series.S02E0${episodeNumber}.1080p-YTS.AG.srt`,
    url: `/subtitle/123/file${episodeNumber}-${language}`,
    language
  });
  const [result, ...others] = processSubdlResults([{
    season: 2, episode_from: 1, episode_end: 8, full_season: true,
    release_name: '1080p - 720p YTS.AG',
    url: '/subtitle/123-456.zip',
    unpack_files: [file(2, 'EL'), file(3, 'EN'), file(3, 'EL'), file(4, 'EL')]
  }], episode, ['el']);
  assert.equal(result.path, '/subtitle/123/file3-EL');
  assert.equal(result.lang, 'el');
  assert.equal(others.length, 0);
  assert.equal(processSubdlResults([{ url: '/subtitle/123-456.zip', season: 2, episode: 4, language: 'EL', name: '1080p YTS.AG.zip' }], episode, ['el']).length, 0);
});

test('SubDL pack handling keeps each selected language and tags it', () => {
  const file = (episodeNumber, language) => ({
    episode: episodeNumber,
    name: `Series.S02E0${episodeNumber}.1080p-YTS.AG.srt`,
    url: `/subtitle/123/file${episodeNumber}-${language}`,
    language
  });
  const results = processSubdlResults([{
    season: 2, episode_from: 1, episode_end: 8, full_season: true,
    release_name: '1080p - 720p YTS.AG',
    url: '/subtitle/123-456.zip',
    unpack_files: [file(3, 'EL'), file(3, 'French'), file(3, 'DE')]
  }], episode, ['el', 'fr']);
  assert.deepEqual(results.map(({ path, lang }) => [path, lang]).sort(),
    [['/subtitle/123/file3-EL', 'el'], ['/subtitle/123/file3-French', 'fr']]);
});

test('converts Windows-1253 Greek subtitles to UTF-8 WebVTT', () => {
  const input = Buffer.concat([
    Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\n'),
    Buffer.from('cae1ebe7ecddf1e1', 'hex')
  ]);
  assert.match(toWebVtt(input), /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.500\nΚαλημέρα/m);
});

test('converts Windows-1251 Russian subtitles using the language encoding', () => {
  // "Привет" in windows-1251
  const input = Buffer.concat([
    Buffer.from('1\n00:00:01,000 --> 00:00:02,500\n'),
    Buffer.from('cff0e8e2e5f2', 'hex')
  ]);
  assert.match(toWebVtt(input, 'ru'), /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.500\nПривет/m);
});

test('parses shared resolutions and keeps individually named releases separate', () => {
  assert.equal(score('Movie.2024.1080p.BluRay-YTS.AG', '1080/720p YTS.AG'), 1);
  const listing = 'Film 1080p WEB-DL NTb / 720p BluRay YTS.AG';
  assert.equal(score('Movie.2024.1080p.WEB-DL-NTb', listing), 1);
  assert.equal(score('Movie.2024.720p.BluRay-YTS.AG', listing), 1);
  assert.equal(score('Movie.2024.1080p.WEB-DL-YTS.AG', listing), undefined);
  assert.equal(score('Movie.2024.1080p.BluRay-YTS.AG', '720p BluRay YTS.AG / 1080p WEB-DL'), undefined);
});
