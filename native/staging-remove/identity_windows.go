package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func identity(file *os.File) (string, string, error) {
	var info syscall.ByHandleFileInformation
	err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info)
	if err != nil {
		return "", "", err
	}
	ino := uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)
	return fmt.Sprint(info.VolumeSerialNumber), fmt.Sprint(ino), nil
}

func retryable(err error) bool {
	return errors.Is(err, syscall.ERROR_ACCESS_DENIED) || errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33)) || errors.Is(err, syscall.ERROR_DIR_NOT_EMPTY)
}
