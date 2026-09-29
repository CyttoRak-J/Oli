package com.cyttos.oli;

/** Test helper (not part of the app): prints what FolderScope makes of each document id. usage: FolderCli <docId>... */
public class FolderCli {
  public static void main(String[] args) {
    for (String id : args) {
      FolderScope s = FolderScope.fromDocumentId(id);
      if (s == null) {
        System.out.println("none");
        continue;
      }
      System.out.println("volume=" + s.volume + " path=" + s.path + " media=" + FolderScope.mediaVolume(s.volume) + " like=" + FolderScope.relativeLike(s.path)
          + " data=" + FolderScope.dataLike("/storage/emulated/0", s.path) + " label=" + s.label());
    }
  }
}
