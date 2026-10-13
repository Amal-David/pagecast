//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func identity(file *os.File) (string, string, error) {
	info, err := file.Stat()
	if err != nil {
		return "", "", err
	}
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprint(uint64(stat.Dev)), fmt.Sprint(uint64(stat.Ino)), nil
}

func retryable(err error) bool {
	return errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES)
}
