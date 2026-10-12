on run
	set appPath to POSIX path of (path to me)
	set viewerDir to do shell script "dirname " & quoted form of appPath
	try
		do shell script quoted form of (viewerDir & "/launch.sh")
	on error
		display dialog "The DICOM viewer needs Python 3." & return & return & "Install it by running this in Terminal:" & return & "xcode-select --install" buttons {"OK"} default button 1 with icon caution
	end try
end run
