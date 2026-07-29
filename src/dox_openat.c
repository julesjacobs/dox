#include <caml/alloc.h>
#include <caml/fail.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <caml/unixsupport.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_NOFOLLOW
#error "Dox direct page reads require O_NOFOLLOW"
#endif

static void close_if_open(int descriptor)
{
  if (descriptor >= 0) close(descriptor);
}

CAMLprim value dox_read_file_nofollow(value root_value, value path_value)
{
  CAMLparam2(root_value, path_value);
  CAMLlocal1(result);
  int directory = -1;
  int leaf = -1;
  int saved_errno = 0;
  const char *operation = "openat";
  char *path = NULL;
  char *buffer = NULL;
  size_t length = 0;
  size_t capacity = 0;

  caml_unix_check_path(root_value, "open");
  caml_unix_check_path(path_value, "openat");

  path = strdup(String_val(path_value));
  if (path == NULL) caml_raise_out_of_memory();

  directory =
      open(String_val(root_value), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) {
    saved_errno = errno;
    operation = "open";
    goto error;
  }

  char *component = path;
  while (1) {
    char *slash = strchr(component, '/');
    int last = slash == NULL;
    if (slash != NULL) *slash = '\0';
    if (component[0] == '\0' || strcmp(component, ".") == 0 ||
        strcmp(component, "..") == 0) {
      saved_errno = EINVAL;
      operation = "openat";
      goto error;
    }

    int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (!last) flags |= O_DIRECTORY;
    int next = openat(directory, component, flags);
    if (next < 0) {
      saved_errno = errno;
      operation = "openat";
      goto error;
    }

    struct stat status;
    if (fstat(next, &status) < 0) {
      saved_errno = errno;
      operation = "fstat";
      close(next);
      goto error;
    }
    if ((!last && !S_ISDIR(status.st_mode)) ||
        (last && !S_ISREG(status.st_mode))) {
      saved_errno = last ? EINVAL : ENOTDIR;
      operation = "openat";
      close(next);
      goto error;
    }

    if (last) {
      leaf = next;
      break;
    }
    close(directory);
    directory = next;
    component = slash + 1;
  }
  close_if_open(directory);
  directory = -1;

  {
    struct stat status;
    if (fstat(leaf, &status) < 0) {
      saved_errno = errno;
      operation = "fstat";
      goto error;
    }
    if (status.st_size < 0 || (uintmax_t)status.st_size > SIZE_MAX) {
      saved_errno = EFBIG;
      operation = "read";
      goto error;
    }
    capacity = (size_t)status.st_size;
    if (capacity < 4096) capacity = 4096;
  }

  buffer = malloc(capacity);
  if (buffer == NULL) {
    close_if_open(leaf);
    free(path);
    caml_raise_out_of_memory();
  }
  while (1) {
    if (length == capacity) {
      if (capacity > SIZE_MAX / 2) {
        saved_errno = EFBIG;
        operation = "read";
        goto error;
      }
      size_t next_capacity = capacity * 2;
      char *next_buffer = realloc(buffer, next_capacity);
      if (next_buffer == NULL) {
        close_if_open(leaf);
        free(path);
        free(buffer);
        caml_raise_out_of_memory();
      }
      buffer = next_buffer;
      capacity = next_capacity;
    }
    ssize_t count = read(leaf, buffer + length, capacity - length);
    if (count > 0) {
      length += (size_t)count;
    } else if (count == 0) {
      break;
    } else if (errno != EINTR) {
      saved_errno = errno;
      operation = "read";
      goto error;
    }
  }

  close_if_open(leaf);
  free(path);
  result = caml_alloc_initialized_string(length, buffer);
  free(buffer);
  CAMLreturn(result);

error:
  close_if_open(leaf);
  close_if_open(directory);
  free(path);
  free(buffer);
  caml_unix_error(saved_errno, operation, path_value);
}
