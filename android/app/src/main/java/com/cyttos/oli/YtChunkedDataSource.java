package com.cyttos.oli;

import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * YouTube's servers refuse an open-ended request that starts late in a file (what a seek sends), but they serve the same
 * bytes when the range is part of the address and short ("&range=a-b"), which is how yt-dlp and the YouTube apps ask.
 * This wrapper turns every read of a googlevideo address into a chain of such short requests; any other address is
 * passed through untouched.
 */
final class YtChunkedDataSource implements DataSource {
  private static final long CHUNK = 6L * 1024 * 1024;

  private final DataSource upstream;
  private boolean chunked;
  private boolean chunkOpen;
  private DataSpec spec;
  private Uri base;
  private long pos;
  private long end;

  YtChunkedDataSource(DataSource upstream) {
    this.upstream = upstream;
  }

  static boolean wanted(Uri u) {
    String host = u.getHost();
    return host != null
        && host.endsWith("googlevideo.com")
        && u.getQueryParameter("clen") != null
        && u.getQueryParameter("range") == null;
  }

  @Override
  public void addTransferListener(@NonNull TransferListener l) {
    upstream.addTransferListener(l);
  }

  @Override
  public long open(@NonNull DataSpec ds) throws IOException {
    chunked = false;
    chunkOpen = false;
    long total = -1;
    if (wanted(ds.uri)) {
      try {
        total = Long.parseLong(ds.uri.getQueryParameter("clen"));
      } catch (NumberFormatException e) {
        total = -1;
      }
    }
    if (total <= 0 || ds.position >= total) return upstream.open(ds);
    chunked = true;
    spec = ds;
    base = ds.uri;
    pos = ds.position;
    end = ds.length == C.LENGTH_UNSET ? total : Math.min(total, ds.position + ds.length);
    openChunk();
    return end - pos;
  }

  private void openChunk() throws IOException {
    long to = Math.min(end, pos + CHUNK) - 1;
    Uri u = base.buildUpon().appendQueryParameter("range", pos + "-" + to).build();
    upstream.open(spec.buildUpon().setUri(u).setPosition(0).setLength(C.LENGTH_UNSET).build());
    chunkOpen = true;
  }

  @Override
  public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
    if (!chunked) return upstream.read(buffer, offset, length);
    if (length == 0) return 0;
    if (pos >= end) return C.RESULT_END_OF_INPUT;
    if (!chunkOpen) openChunk();
    int n = upstream.read(buffer, offset, length);
    if (n == C.RESULT_END_OF_INPUT) {
      upstream.close();
      chunkOpen = false;
      if (pos >= end) return C.RESULT_END_OF_INPUT;
      openChunk();
      n = upstream.read(buffer, offset, length);
      if (n == C.RESULT_END_OF_INPUT) return C.RESULT_END_OF_INPUT;
    }
    pos += n;
    return n;
  }

  @Nullable
  @Override
  public Uri getUri() {
    return upstream.getUri();
  }

  @NonNull
  @Override
  public Map<String, List<String>> getResponseHeaders() {
    return upstream.getResponseHeaders();
  }

  @Override
  public void close() throws IOException {
    if (!chunked || chunkOpen) upstream.close();
    chunkOpen = false;
  }
}
