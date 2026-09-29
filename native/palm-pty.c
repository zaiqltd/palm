// palm-pty: runs one program on a pseudo-terminal for Palm's terminal sessions.
//
//   palm-pty <cols> <rows> <cwd> <program> [args...]
//
// fd 0  -> bytes typed on the phone, written to the terminal
// fd 1  <- terminal output bytes
// fd 3  -> control lines: "R <cols> <rows>" resizes, "S <signal>" signals the
//          foreground process group, "H" hangs up the session.
// The helper exits with the program's status. Closing fd 0 hangs up the program.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

static pid_t child = -1;
static int master = -1;

static int write_all(int fd, const char *buffer, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, buffer, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) {
        struct pollfd p = {fd, POLLOUT, 0};
        poll(&p, 1, 100);
        continue;
      }
      return -1;
    }
    buffer += written;
    length -= (size_t)written;
  }
  return 0;
}

static void hangup(void) {
  if (child > 0) {
    pid_t group = getpgid(child);
    if (group > 0) kill(-group, SIGHUP);
    kill(child, SIGHUP);
  }
}

static int finish(void) {
  int status = 0;
  if (child > 0) {
    // Give the shell a moment to exit after hangup, then insist.
    for (int i = 0; i < 20; i++) {
      pid_t done = waitpid(child, &status, WNOHANG);
      if (done == child) goto exited;
      usleep(50000);
    }
    kill(child, SIGKILL);
    waitpid(child, &status, 0);
  }
exited:
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

static void control(char *line) {
  if (line[0] == 'R') {
    int cols = 0, rows = 0;
    if (sscanf(line + 1, "%d %d", &cols, &rows) == 2 && cols >= 2 && cols <= 1000 && rows >= 1 &&
        rows <= 500) {
      struct winsize size = {(unsigned short)rows, (unsigned short)cols, 0, 0};
      ioctl(master, TIOCSWINSZ, &size);
    }
  } else if (line[0] == 'S') {
    int number = atoi(line + 1);
    if (number == SIGINT || number == SIGTERM || number == SIGKILL || number == SIGQUIT ||
        number == SIGTSTP || number == SIGCONT || number == SIGHUP) {
      pid_t group = tcgetpgrp(master);
      if (group > 0) kill(-group, number);
    }
  } else if (line[0] == 'H') {
    hangup();
  }
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: palm-pty cols rows cwd program [args...]\n");
    return 64;
  }
  int cols = atoi(argv[1]);
  int rows = atoi(argv[2]);
  if (cols < 2 || cols > 1000) cols = 80;
  if (rows < 1 || rows > 500) rows = 24;
  const char *cwd = argv[3];
  struct winsize size = {(unsigned short)rows, (unsigned short)cols, 0, 0};
  signal(SIGPIPE, SIG_IGN);
  child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) {
    perror("forkpty");
    return 70;
  }
  if (child == 0) {
    if (chdir(cwd) != 0) chdir(getenv("HOME") ? getenv("HOME") : "/");
    signal(SIGPIPE, SIG_DFL);
    execvp(argv[4], argv + 4);
    fprintf(stderr, "palm-pty: could not start %s: %s\r\n", argv[4], strerror(errno));
    _exit(127);
  }
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  int control_fd = fcntl(3, F_GETFD) >= 0 ? 3 : -1;
  char control_line[256];
  size_t control_length = 0;
  char buffer[65536];
  int input_open = 1;
  for (;;) {
    struct pollfd fds[3];
    int count = 0;
    fds[count++] = (struct pollfd){master, POLLIN, 0};
    int input_index = -1, control_index = -1;
    if (input_open) {
      input_index = count;
      fds[count++] = (struct pollfd){0, POLLIN, 0};
    }
    if (control_fd >= 0) {
      control_index = count;
      fds[count++] = (struct pollfd){control_fd, POLLIN, 0};
    }
    int ready = poll(fds, (nfds_t)count, 1000);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(master, buffer, sizeof buffer);
      if (n > 0) {
        if (write_all(1, buffer, (size_t)n) < 0) {
          hangup();
          break;
        }
      } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
        break;  // The program exited and closed the terminal.
      }
    }
    if (input_index >= 0 && (fds[input_index].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t n = read(0, buffer, sizeof buffer);
      if (n > 0) {
        write_all(master, buffer, (size_t)n);
      } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
        input_open = 0;
        hangup();
      }
    }
    if (control_index >= 0 && (fds[control_index].revents & (POLLIN | POLLHUP | POLLERR))) {
      char chunk[256];
      ssize_t n = read(control_fd, chunk, sizeof chunk);
      if (n <= 0) {
        control_fd = -1;
      } else {
        for (ssize_t i = 0; i < n; i++) {
          if (chunk[i] == '\n') {
            control_line[control_length] = 0;
            control(control_line);
            control_length = 0;
          } else if (control_length < sizeof control_line - 1) {
            control_line[control_length++] = chunk[i];
          }
        }
      }
    }
    int status;
    if (waitpid(child, &status, WNOHANG) == child) {
      // Drain what the program printed before it exited.
      for (;;) {
        ssize_t n = read(master, buffer, sizeof buffer);
        if (n <= 0) break;
        write_all(1, buffer, (size_t)n);
      }
      child = -1;
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 1;
    }
  }
  return finish();
}
